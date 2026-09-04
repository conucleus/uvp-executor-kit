import {
  getSignalContainer,
  getSignalContainerProof,
  listSignalContainers,
  resolveProductApiFetch,
  summarizeSignalContainer,
  summarizeSubmittedSignalContainer,
  type ProductApiClientOptions,
  type ProductApiAuthStatus,
  type ProductSignalContainer,
  type ProductTaskSummary,
  type SubmittedSignalContainer,
  type SubmittedSignalContainerSummary,
} from './product.js';
import { classifyExecutorKitError } from './errors.js';
import { normalizeAddress } from './validation.js';

export interface ProductDoctorInput extends ProductApiClientOptions {
  readonly walletAddress?: string;
  readonly taskId?: string;
  readonly submissionId?: string;
  readonly verbose?: boolean;
  readonly auth?: ProductApiAuthStatus;
}

export interface ProductDoctorCheck {
  readonly ok: boolean;
  readonly label: string;
  readonly detail?: string;
  readonly latencyMs?: number;
}

export interface TaskReadinessResult {
  readonly ok: boolean;
  readonly check: ProductDoctorCheck;
  readonly taskId: string;
  readonly orderId: string;
  readonly title: string;
  readonly status: string;
  readonly canSubmit: boolean;
  readonly blockedReason?: string;
  readonly assigneeMatch: boolean;
  readonly configuredWallet: string;
  readonly taskAssignee?: string;
  readonly stageName?: string;
  readonly deadline?: string;
  readonly deadlineExpired?: boolean;
  readonly requiredEvidence: readonly string[];
  readonly primaryActionLabel?: string;
  readonly nextAction: 'prepare' | 'wait' | 'proof' | 'blocked';
  readonly nextActionLabel: string;
}

export interface ProductDoctorOutput {
  readonly ok: boolean;
  readonly checks: readonly ProductDoctorCheck[];
  readonly chainServicesUrl: string;
  readonly timestamp: string;
  readonly principalId?: string;
  readonly auth?: ProductApiAuthStatus;
  readonly walletAddress?: string;
  readonly tasks?: readonly ProductTaskSummary[];
  readonly proof?: SubmittedSignalContainerSummary;
  readonly taskReadiness?: TaskReadinessResult;
  readonly rawTasks?: readonly ProductSignalContainer[];
  readonly rawProof?: SubmittedSignalContainer;
  readonly rawTaskReadiness?: ProductSignalContainer;
}

interface TaskVisibilityResult {
  readonly check: ProductDoctorCheck;
  readonly tasks?: readonly ProductTaskSummary[];
  readonly rawTasks?: readonly ProductSignalContainer[];
}

interface ProofEndpointResult {
  readonly check: ProductDoctorCheck;
  readonly proof?: SubmittedSignalContainerSummary;
  readonly rawProof?: SubmittedSignalContainer;
}

export async function runProductDoctor(input: ProductDoctorInput): Promise<ProductDoctorOutput> {
  const timestamp = new Date().toISOString();
  const checks: ProductDoctorCheck[] = [];
  let tasks: readonly ProductTaskSummary[] | undefined;
  let rawTasks: readonly ProductSignalContainer[] | undefined;
  let proof: SubmittedSignalContainerSummary | undefined;
  let rawProof: SubmittedSignalContainer | undefined;
  let walletAddress: string | undefined;
  let taskReadiness: TaskReadinessResult | undefined;
  let rawTaskReadiness: ProductSignalContainer | undefined;

  const reachability = await checkReachability(input);
  checks.push(reachability);

  const effectiveWallet = input.walletAddress
    ? normalizeAddress(input.walletAddress, 'walletAddress')
    : undefined;
  if (effectiveWallet) {
    walletAddress = effectiveWallet;
  }

  if (effectiveWallet && !input.taskId) {
    const result = await checkTaskVisibility(input, effectiveWallet);
    checks.push(result.check);
    tasks = result.tasks;
    rawTasks = result.rawTasks;
  }

  if (input.taskId) {
    const result = await checkTaskReadiness(input, input.taskId, effectiveWallet);
    checks.push(result.check);
    taskReadiness = result.readiness;
    rawTaskReadiness = result.rawTask;
  }

  if (input.submissionId) {
    const result = await checkProofEndpoint(input, input.submissionId);
    checks.push(result.check);
    proof = result.proof;
    rawProof = result.rawProof;
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    chainServicesUrl: input.chainServicesUrl,
    timestamp,
    ...(input.principalId ? { principalId: input.principalId } : {}),
    ...(input.auth ? { auth: input.auth } : {}),
    ...(walletAddress ? { walletAddress } : {}),
    ...(tasks ? { tasks } : {}),
    ...(proof ? { proof } : {}),
    ...(taskReadiness ? { taskReadiness } : {}),
    ...(input.verbose && rawTasks ? { rawTasks } : {}),
    ...(input.verbose && rawProof ? { rawProof } : {}),
    ...(input.verbose && rawTaskReadiness ? { rawTaskReadiness } : {}),
  };
}

async function checkReachability(
  input: ProductApiClientOptions,
): Promise<ProductDoctorCheck> {
  const started = Date.now();
  try {
    const fetchFn = resolveProductApiFetch(input.fetch);
    const url = stripTrailingSlash(input.chainServicesUrl);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...input.headers,
    };
    if (input.principalId && input.principalId.trim().length > 0) {
      headers['x-uvp-principal-id'] = input.principalId.trim();
    }
    const response = await fetchFn(url, { method: 'GET', headers });
    const latencyMs = Date.now() - started;
    if (response.ok || response.status < 500) {
      return { ok: true, label: 'reachability', detail: `Product API responded HTTP ${response.status}`, latencyMs };
    }
    return { ok: false, label: 'reachability', detail: `Product API HTTP ${response.status}`, latencyMs };
  } catch (error) {
    const classified = classifyExecutorKitError(error, 'unknown');
    return { ok: false, label: 'reachability', detail: classified.message, latencyMs: Date.now() - started };
  }
}

async function checkTaskVisibility(
  input: ProductApiClientOptions,
  walletAddress: string,
): Promise<TaskVisibilityResult> {
  const started = Date.now();
  try {
    const rawTasks = await listSignalContainers({
      ...input,
      walletAddress,
    });
    const latencyMs = Date.now() - started;
    return {
      check: {
        ok: true,
        label: 'task-visibility',
        detail: rawTasks.length === 0
          ? 'No tasks visible for this wallet'
          : `${rawTasks.length} task(s) visible for this wallet`,
        latencyMs,
      },
      tasks: rawTasks.map((t) => summarizeSignalContainer(t)),
      rawTasks,
    };
  } catch (error) {
    const classified = classifyExecutorKitError(error, 'unknown');
    return {
      check: {
        ok: false,
        label: 'task-visibility',
        detail: classified.message,
        latencyMs: Date.now() - started,
      },
    };
  }
}

async function checkProofEndpoint(
  input: ProductApiClientOptions,
  submissionId: string,
): Promise<ProofEndpointResult> {
  const started = Date.now();
  try {
    const submission = await getSignalContainerProof({
      ...input,
      submissionId,
    });
    const latencyMs = Date.now() - started;
    return {
      check: {
        ok: true,
        label: 'proof-endpoint',
        detail: `Submission ${submissionId} status: ${submission.status}`,
        latencyMs,
      },
      proof: summarizeSubmittedSignalContainer(submission),
      rawProof: submission,
    };
  } catch (error) {
    const classified = classifyExecutorKitError(error, 'unknown');
    return {
      check: {
        ok: false,
        label: 'proof-endpoint',
        detail: classified.message,
        latencyMs: Date.now() - started,
      },
    };
  }
}

interface TaskReadinessCheckResult {
  readonly check: ProductDoctorCheck;
  readonly readiness?: TaskReadinessResult;
  readonly rawTask?: ProductSignalContainer;
}

async function checkTaskReadiness(
  input: ProductApiClientOptions,
  taskId: string,
  walletAddress: string | undefined,
): Promise<TaskReadinessCheckResult> {
  const started = Date.now();
  try {
    const rawTask = await getSignalContainer({
      ...input,
      taskId,
      ...(walletAddress ? { walletAddress } : {}),
    });
    const summary = summarizeSignalContainer(rawTask);
    const latencyMs = Date.now() - started;

    const assigneeMatch = walletAddress && summary.assigneeWallet
      ? normalizeAddress(summary.assigneeWallet, 'task.assigneeWallet') === normalizeAddress(walletAddress, 'walletAddress')
      : walletAddress ? false : true;
    const now = new Date();
    const deadlineExpired = summary.deadline ? new Date(summary.deadline).getTime() <= now.getTime() : undefined;
    const canSubmit = summary.canSubmit === true && !deadlineExpired && (assigneeMatch || !walletAddress);
    const blockedReason = summary.canSubmit === false ? (summary.blockedReason ?? 'Submission not available') : undefined;

    let nextAction: TaskReadinessResult['nextAction'] = 'blocked';
    let nextActionLabel = 'This task is not ready for action.';

    // Product's frozen TaskStatus completion enum is `done`.  Keep the
    // legacy aliases for compatibility with older Product API deployments,
    // but never omit the canonical completion state or proof guidance becomes
    // unreachable for completed tasks.
    if (summary.status === 'done' || summary.status === 'confirmed' || summary.status === 'completed') {
      nextAction = 'proof';
      nextActionLabel = 'Task is complete. Run product proof to verify on-chain confirmation.';
    } else if (canSubmit) {
      nextAction = 'prepare';
      nextActionLabel = 'Ready to prepare. Run product prepare to build the signal container.';
    } else if (summary.status === 'closed' || summary.status === 'cancelled') {
      nextAction = 'blocked';
      nextActionLabel = `Task is ${summary.status} and cannot be acted on.`;
    } else if (deadlineExpired) {
      nextAction = 'blocked';
      nextActionLabel = 'Deadline has expired. This task cannot be submitted.';
    } else if (walletAddress && !assigneeMatch) {
      nextAction = 'blocked';
      nextActionLabel = `Configured wallet ${walletAddress} is not the task assignee.`;
    } else {
      nextAction = 'wait';
      nextActionLabel = blockedReason ?? 'Task is not yet ready for submission. Check the blocked reason.';
    }

    return {
      check: {
        ok: canSubmit || summary.status === 'done' || summary.status === 'confirmed' || summary.status === 'completed',
        label: 'task-readiness',
        detail: nextActionLabel,
        latencyMs,
      },
      readiness: {
        ok: canSubmit || summary.status === 'confirmed' || summary.status === 'completed',
        check: { ok: true, label: 'task-readiness', detail: nextActionLabel, latencyMs },
        taskId: summary.taskId,
        orderId: summary.orderId,
        title: summary.title,
        status: summary.status,
        canSubmit,
        ...(blockedReason ? { blockedReason } : {}),
        assigneeMatch,
        configuredWallet: walletAddress ?? '',
        ...(summary.assigneeWallet ? { taskAssignee: summary.assigneeWallet } : {}),
        ...(summary.stageName ? { stageName: summary.stageName } : {}),
        ...(summary.deadline ? { deadline: summary.deadline } : {}),
        ...(deadlineExpired !== undefined ? { deadlineExpired } : {}),
        requiredEvidence: summary.requiredEvidence ?? [],
        ...(summary.primaryActionLabel ? { primaryActionLabel: summary.primaryActionLabel } : {}),
        nextAction,
        nextActionLabel,
      },
      rawTask,
    };
  } catch (error) {
    const classified = classifyExecutorKitError(error, 'unknown');
    // No synthesized placeholder task/readiness data: the report only carries the failed check.
    return {
      check: {
        ok: false,
        label: 'task-readiness',
        detail: classified.message,
        latencyMs: Date.now() - started,
      },
    };
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
