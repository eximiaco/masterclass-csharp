import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveAuthProfile,
  prepareControlledRun,
  startControlledStack,
  stopControlledStack,
  compose,
  createRunPaths,
  sanitizeControlledText,
  executeProcess,
  interruptControlledProcesses,
} from '../../../../../contexts/core/frontend/e2e/identity/controller.mjs';
import { resolveTargets, listSpecs } from './targets.mjs';
import { playwrightArgs } from './cli.mjs';
import { parseResults, verdictOf } from './results.mjs';
import { renderSummary } from './summary.mjs';
export {
  resolveEnvironment,
  resolveAuthProfile,
} from '../../../../../contexts/core/frontend/e2e/identity/controller.mjs';

async function gitInfo(root) {
  const result = await executeProcess('git', ['log', '-1', '--format=%H'], {
    cwd: root,
    echo: false,
  });
  const branch = await executeProcess('git', ['branch', '--show-current'], {
    cwd: root,
    echo: false,
  });
  return { head: result.output.trim(), branch: branch.output.trim() };
}

async function saveReport(report, filename) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    path.join(path.dirname(filename), 'summary.md'),
    renderSummary(report),
  );
}

async function captureLogs(root, run, report, command = compose) {
  const result = await command(
    root,
    run,
    ['logs', '--no-color', '--no-log-prefix'],
    { echo: false },
  );
  const log = path.join(run.marker.outDir, 'controlled-stack.log');
  await writeFile(log, sanitizeControlledText(result.output, run.credentials));
  report.logs = {
    controlled: {
      file: log,
      window: null,
      highlights: { total_matches: 0, lines: [] },
    },
  };
}

function artifacts(run) {
  const { outDir, runtime } = run.marker;
  return {
    dir: outDir,
    report_json: path.join(outDir, 'report.json'),
    summary_md: path.join(outDir, 'summary.md'),
    results_json: path.join(runtime, 'test-results/e2e-results.json'),
    html_report: path.join(runtime, 'playwright-report/index.html'),
    test_results_dir: path.join(runtime, 'test-results'),
    controlled_runtime: runtime,
  };
}

async function collectResults(run, frontendDir, report) {
  const filename = path.join(
    run.marker.runtime,
    'test-results/e2e-results.json',
  );
  const original = await readFile(filename, 'utf8');
  const parsed = parseResults(
    JSON.parse(sanitizeControlledText(original, run.credentials)),
    { frontendDir },
  );
  const normalized = JSON.parse(
    JSON.stringify(parsed)
      .split(path.join(frontendDir, 'test-results'))
      .join(path.join(run.marker.runtime, 'test-results')),
  );
  Object.assign(report, normalized, { verdict: verdictOf(parsed) });
}

/** Modo controlado do runner oficial; nunca consulta .env STG. Exemplo: runControlled(root, opts). */
export async function runControlled(root, opts) {
  const frontendDir = path.join(root, 'contexts/core/frontend');
  const authProfile = resolveAuthProfile(
    process.env.FTC_E2E_AUTH_PROFILE,
    'controlled',
  );
  const { resolved, errors } = resolveTargets(opts.targets, {
    repoRoot: root,
    frontendDir,
  });
  if (errors.length)
    throw new Error(errors.map((error) => error.message).join('; '));
  if (opts.list)
    return {
      exitCode: 0,
      output: {
        status: 'ok',
        mode: 'list',
        environment: 'controlled',
        specs: listSpecs(
          resolved.length ? resolved : [{ path: 'e2e/features', kind: 'dir' }],
          { frontendDir },
        ),
      },
    };
  const args = playwrightArgs(opts, resolved);
  if (opts.retries == null) args.push('--retries', '0');
  if (opts.dryRun)
    return {
      exitCode: 0,
      output: {
        status: 'ok',
        mode: 'dry-run',
        environment: 'controlled',
        auth_profile: authProfile,
        targets: resolved,
        playwright_args: args,
        stack: {
          mode: opts.noStack ? 'no-stack' : 'up',
          teardown: opts.keepStack ? 'skip' : 'down',
        },
        out_dir: createRunPaths(root, opts.out).outDir,
        env_file_present: false,
      },
    };
  const run = await prepareControlledRun(root, opts);
  return await executeControlledRun(
    root,
    frontendDir,
    opts,
    resolved,
    args,
    run,
  );
}

export async function executeControlledRun(
  root,
  frontendDir,
  opts,
  targets,
  args,
  run,
  engine = {
    start: startControlledStack,
    command: compose,
    stop: stopControlledStack,
    interrupt: interruptControlledProcesses,
  },
) {
  const report = {
    run_id: run.marker.id,
    environment: 'controlled',
    verdict: 'infra-error',
    git: await gitInfo(root),
    targets,
    playwright_args: args,
    versions: run.versions,
    stack: {
      mode: opts.noStack ? 'no-stack' : 'up',
      db_mode: 'isolated',
      up_seconds: null,
    },
    stats: null,
    tests: [],
    failures: [],
    run_errors: [],
    logs: {},
    infra_error: null,
    teardown: { performed: false, status: 'pending' },
    artifacts: artifacts(run),
    next_steps: [],
  };
  let interrupted = false;
  let finalizing = false;
  let cancellation = Promise.resolve();
  const onInterrupt = () => {
    interrupted = true;
    if (!finalizing) cancellation = engine.interrupt?.() ?? Promise.resolve();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    const started = Date.now();
    if (!opts.noStack) await engine.start(root, run);
    if (run.credentials.authProfile === 'auth-integrated')
      run.credentials = JSON.parse(
        await readFile(
          path.join(run.marker.runtime, 'credentials.json'),
          'utf8',
        ),
      );
    report.stack.up_seconds = Math.round((Date.now() - started) / 1000);
    const images = await engine.command(
      root,
      run,
      ['images', '--format', 'json'],
      { echo: false },
    );
    report.images = images.output.trim();
    const result = await engine.command(root, run, [
      'run',
      '--rm',
      '--no-deps',
      'playwright',
      ...args,
    ]);
    if (run.credentials.authProfile === 'auth-integrated')
      run.credentials = JSON.parse(
        await readFile(
          path.join(run.marker.runtime, 'credentials.json'),
          'utf8',
        ),
      );
    await collectResults(run, frontendDir, report);
    if (result.exit_code !== 0 && report.verdict === 'passed')
      report.verdict = 'failed';
  } catch (error) {
    report.infra_error = {
      step: error.phase || 'controlled',
      message: sanitizeControlledText(error.message, run.credentials),
      exit_code: error.result?.exit_code ?? 2,
    };
  } finally {
    finalizing = true;
    await cancellation;
    try {
      if (run.credentials.authProfile === 'auth-integrated')
        run.credentials = JSON.parse(
          await readFile(
            path.join(run.marker.runtime, 'credentials.json'),
            'utf8',
          ),
        );
      if (opts.logs !== 'never')
        await captureLogs(root, run, report, engine.command);
    } catch (error) {
      report.run_errors.push({
        message: sanitizeControlledText(
          `Coleta de logs falhou: ${error.message}`,
          run.credentials,
        ),
      });
      report.verdict = 'infra-error';
    }
    try {
      if (opts.keepStack)
        report.teardown = {
          performed: false,
          status: 'skipped',
          reason: '--keep-stack',
        };
      else {
        const result = await engine.stop(root, run);
        report.teardown = {
          performed: true,
          status: result.exit_code === 0 ? 'ok' : 'error',
        };
        if (result.exit_code !== 0) report.verdict = 'infra-error';
      }
    } catch (error) {
      report.teardown = {
        performed: true,
        status: 'error',
        reason: sanitizeControlledText(error.message, run.credentials),
      };
      report.verdict = 'infra-error';
    }
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    if (interrupted) {
      report.verdict = 'infra-error';
      report.infra_error = {
        step: 'interrupted',
        message:
          'Execução interrompida; término dos filhos e teardown reconciliados',
      };
    }
  }
  await saveReport(report, report.artifacts.report_json);
  const exitCode =
    report.verdict === 'passed' ? 0 : report.verdict === 'failed' ? 1 : 2;
  const { tests, ...compact } = report;
  return {
    exitCode,
    output: {
      status: exitCode === 0 ? 'ok' : exitCode === 1 ? 'failed' : 'error',
      ...compact,
      tests_total: tests.length,
    },
  };
}
