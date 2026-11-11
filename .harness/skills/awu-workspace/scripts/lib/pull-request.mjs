import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProgram, parseOriginSlug, parseAzureDevOpsRemote } from "./git.mjs";

const ApiVersion = "7.1";
const TimeoutMs = 15000;
const encode = encodeURIComponent;

/** Segmento vindo do remote pode já estar percent-encoded; normaliza para não codificar duas vezes. */
function segment(value) {
  try {
    return encode(decodeURIComponent(value));
  } catch {
    return encode(value);
  }
}

/** PR não automatizável: o push já aconteceu, então a falha vira instrução, não erro. */
const manual = (provider, reason, createUrl = null) => ({ mode: "manual", provider, number: null, url: null, create_url: createUrl, reason });

function adoWebUrl(ado, pr) {
  return pr?._links?.web?.href ?? `${ado.web_base}/${ado.project}/_git/${ado.repo}/pullrequest/${pr.pullRequestId}`;
}

async function adoCall(ado, pat, method, resource, payload) {
  const url = `${ado.api_base}/${segment(ado.project)}/_apis/git/repositories/${segment(ado.repo)}/pullrequests${resource}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(TimeoutMs),
  });
  if (!response.ok) throw new Error(`API do Azure DevOps respondeu ${response.status} em ${method} pullrequests`);
  return response.json();
}

async function ensureAzure(request) {
  const ado = parseAzureDevOpsRemote(request.remoteUrl);
  if (!ado) return manual("azure-devops", "remote origin não é um repositório Azure DevOps reconhecido");
  const createUrl = `${ado.web_base}/${ado.project}/_git/${ado.repo}/pullrequestcreate?sourceRef=${encode(request.source)}&targetRef=${encode(request.target)}`;
  const pat = process.env.AZURE_DEVOPS_PAT?.trim();
  if (!pat) return manual("azure-devops", "AZURE_DEVOPS_PAT não definida", createUrl);
  const refs = { sourceRefName: `refs/heads/${request.source}`, targetRefName: `refs/heads/${request.target}` };
  const search = new URLSearchParams({
    "searchCriteria.sourceRefName": refs.sourceRefName,
    "searchCriteria.targetRefName": refs.targetRefName,
    "searchCriteria.status": "active",
    "api-version": ApiVersion,
  });
  try {
    const active = (await adoCall(ado, pat, "GET", `?${search}`)).value?.[0];
    const pr = active ?? (await adoCall(ado, pat, "POST", `?api-version=${ApiVersion}`, { ...refs, title: request.title, description: request.body }));
    return { mode: active ? "existing" : "created", provider: "azure-devops", number: pr.pullRequestId ?? null, url: adoWebUrl(ado, pr) };
  } catch (error) {
    return manual("azure-devops", error.name === "TimeoutError" ? "API do Azure DevOps sem resposta em 15s" : error.message, createUrl);
  }
}

function ghJson(args) {
  const outcome = runProgram("gh", args, { env: { ...process.env, GH_PAGER: "cat", PAGER: "cat" } });
  if (outcome.code !== 0) throw new Error(`gh ${args[0]} ${args[1]} falhou (exit ${outcome.code})`);
  return outcome.stdout;
}

function createGithub(slug, request) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "awu-workspace-pr-"));
  try {
    const bodyFile = path.join(directory, "body.md");
    fs.writeFileSync(bodyFile, request.body);
    const output = ghJson(["pr", "create", "--repo", slug, "--base", request.target, "--head", request.source, "--title", request.title, "--body-file", bodyFile]);
    const url = output.match(/https:\/\/\S+/)?.[0] ?? null;
    return { mode: "created", provider: "github", number: Number(url?.match(/\/pull\/(\d+)/)?.[1]) || null, url };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function ensureGithub(request) {
  const slug = parseOriginSlug(request.remoteUrl);
  if (!slug) return manual("github", "remote origin não é um repositório GitHub reconhecido");
  const compare = `https://github.com/${slug}/compare/${request.target}...${encode(request.source)}?expand=1`;
  if (runProgram("gh", ["--version"]).code !== 0) return manual("github", "GitHub CLI (gh) indisponível", compare);
  try {
    const open = JSON.parse(ghJson(["pr", "list", "--repo", slug, "--head", request.source, "--state", "open", "--json", "number,url", "--limit", "1"]));
    if (open.length) return { mode: "existing", provider: "github", number: open[0].number, url: open[0].url };
    return createGithub(slug, request);
  } catch (error) {
    return manual("github", error.message, compare);
  }
}

/**
 * Reaproveita o PR aberto da branch ou cria um; sem credencial devolve o link de criação.
 * Uso: await ensurePullRequest({ provider, remoteUrl, source, target, title, body }).
 */
export async function ensurePullRequest(request) {
  return request.provider === "azure-devops" ? ensureAzure(request) : ensureGithub(request);
}

async function azureMerged(request) {
  const ado = parseAzureDevOpsRemote(request.remoteUrl);
  const pat = process.env.AZURE_DEVOPS_PAT?.trim();
  if (!ado || !pat) return false;
  const pr = await adoCall(ado, pat, "GET", `/${request.number}?api-version=${ApiVersion}`);
  return pr.status === "completed" && pr.lastMergeSourceCommit?.commitId === request.tip;
}

function githubMerged(request) {
  const slug = parseOriginSlug(request.remoteUrl);
  if (!slug || runProgram("gh", ["--version"]).code !== 0) return false;
  const pr = JSON.parse(ghJson(["pr", "view", String(request.number), "--repo", slug, "--json", "state,headRefOid"]));
  return pr.state === "MERGED" && pr.headRefOid === request.tip;
}

/**
 * Verdadeiro só quando o provedor confirma PR concluído cujo último commit de origem
 * é o tip informado. Indisponibilidade responde falso: nunca presume merge.
 * Uso: await pullRequestMerged({ provider, remoteUrl, number, tip }).
 */
export async function pullRequestMerged(request) {
  if (!request.number) return false;
  try {
    return request.provider === "azure-devops" ? await azureMerged(request) : githubMerged(request);
  } catch {
    return false;
  }
}
