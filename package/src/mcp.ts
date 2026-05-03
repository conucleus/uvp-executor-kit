import type { Address } from 'viem';
import {
  runProductDoctor,
  type ProductDoctorInput,
  type ProductDoctorOutput,
} from './doctor.js';
import {
  getSignalContainer,
  getSignalContainerProof,
  hashContainerEvidence,
  listSignalContainers,
  parsePreparedSignalContainer,
  prepareSignalContainer,
  signPreparedSignalContainer,
  submitPreparedSignalContainer,
  summarizePreparedSignalContainer,
  summarizeSignalContainer,
  summarizeSubmittedSignalContainer,
  type GetSignalContainerInput,
  type HashContainerEvidenceInput,
  type ListSignalContainersInput,
  type PreparedSignalContainer,
  type PreparedSignalContainerSummary,
  type ProductApiClientOptions,
  type ProductSignalContainer,
  type ProductSubmitIntent,
  type ProductTaskSummary,
  type SubmittedSignalContainer,
  type SubmittedSignalContainerSummary,
} from './product.js';
import { ValidationError } from './validation.js';

export interface ProductMcpAdapterOptions extends ProductApiClientOptions {}

export interface ProductMcpToolOptions {
  readonly includeRaw?: boolean;
}

export interface ProductMcpListTasksInput extends ProductMcpToolOptions {
  readonly walletAddress: Address | string;
  readonly orderId?: string;
  readonly status?: string;
}

export interface ProductMcpGetTaskInput extends ProductMcpToolOptions {
  readonly taskId: string;
  readonly walletAddress?: Address | string;
}

export interface ProductMcpHashEvidenceInput extends HashContainerEvidenceInput {}

export interface ProductMcpPrepareSignalInput extends ProductMcpToolOptions {
  readonly taskId: string;
  readonly walletAddress: Address | string;
  readonly evidenceIds: readonly string[];
  readonly intent: ProductSubmitIntent;
}

export interface ProductMcpSubmitSignalInput extends ProductMcpToolOptions {
  readonly prepared: PreparedSignalContainer | Record<string, unknown>;
  readonly privateKeyEnv: string;
  readonly taskId?: string;
  readonly prepareId?: string;
  readonly walletAddress?: Address | string;
}

export interface ProductMcpGetProofInput extends ProductMcpToolOptions {
  readonly submissionId: string;
}

export interface ProductMcpListTasksOutput {
  readonly tasks: readonly ProductTaskSummary[];
  readonly rawTasks?: readonly ProductSignalContainer[];
}

export interface ProductMcpGetTaskOutput {
  readonly task: ProductTaskSummary;
  readonly rawTask?: ProductSignalContainer;
}

export interface ProductMcpPrepareSignalOutput {
  readonly prepared: PreparedSignalContainerSummary;
  readonly rawPrepared?: PreparedSignalContainer;
}

export interface ProductMcpSubmitSignalOutput {
  readonly submission: SubmittedSignalContainerSummary;
  readonly rawSubmission?: SubmittedSignalContainer;
}

export interface ProductMcpGetProofOutput {
  readonly submission: SubmittedSignalContainerSummary;
  readonly rawSubmission?: SubmittedSignalContainer;
}

export interface ProductMcpAdapter {
  readonly uvp_list_tasks: (input: ProductMcpListTasksInput) => Promise<ProductMcpListTasksOutput>;
  readonly uvp_get_task: (input: ProductMcpGetTaskInput) => Promise<ProductMcpGetTaskOutput>;
  readonly uvp_prepare_signal: (input: ProductMcpPrepareSignalInput) => Promise<ProductMcpPrepareSignalOutput>;
  readonly uvp_hash_evidence: (input: ProductMcpHashEvidenceInput) => ReturnType<typeof hashContainerEvidence>;
  readonly uvp_submit_signal: (input: ProductMcpSubmitSignalInput) => Promise<ProductMcpSubmitSignalOutput>;
  readonly uvp_get_proof: (input: ProductMcpGetProofInput) => Promise<ProductMcpGetProofOutput>;
  readonly uvp_doctor: (input: ProductDoctorInput) => Promise<ProductDoctorOutput>;
}

export function createProductMcpAdapter(options: ProductMcpAdapterOptions): ProductMcpAdapter {
  const clientOptions = productMcpClientOptions(options);
  return {
    uvp_list_tasks: async (input) => {
      const request: ListSignalContainersInput = {
        ...clientOptions,
        walletAddress: input.walletAddress,
        ...(input.orderId ? { orderId: input.orderId } : {}),
        ...(input.status ? { status: input.status } : {}),
      };
      const tasks = await listSignalContainers(request);
      return {
        tasks: tasks.map((task) => summarizeSignalContainer(task)),
        ...(input.includeRaw ? { rawTasks: tasks } : {}),
      };
    },
    uvp_get_task: async (input) => {
      const request: GetSignalContainerInput = {
        ...clientOptions,
        taskId: input.taskId,
        ...(input.walletAddress ? { walletAddress: input.walletAddress } : {}),
      };
      const task = await getSignalContainer(request);
      return {
        task: summarizeSignalContainer(task),
        ...(input.includeRaw ? { rawTask: task } : {}),
      };
    },
    uvp_prepare_signal: async (input) => {
      const prepared = await prepareSignalContainer({
        ...clientOptions,
        taskId: input.taskId,
        walletAddress: input.walletAddress,
        evidenceIds: input.evidenceIds,
        intent: input.intent,
      });
      return {
        prepared: summarizePreparedSignalContainer(prepared),
        ...(input.includeRaw ? { rawPrepared: prepared } : {}),
      };
    },
    uvp_hash_evidence: (input) => hashContainerEvidence(input),
    uvp_submit_signal: async (input) => {
      const prepared = parsePreparedSignalContainer(input.prepared, 'prepared signal');
      const taskId = input.taskId ?? prepared.taskId;
      const prepareId = input.prepareId ?? prepared.prepareId;
      if (taskId !== prepared.taskId) {
        throw new ValidationError('taskId does not match prepared signal');
      }
      if (prepareId !== prepared.prepareId) {
        throw new ValidationError('prepareId does not match prepared signal');
      }
      const signed = await signPreparedSignalContainer({
        prepared,
        privateKeyEnv: input.privateKeyEnv,
        ...(input.walletAddress ? { walletAddress: input.walletAddress } : {}),
      });
      const submission = await submitPreparedSignalContainer({
        ...clientOptions,
        taskId,
        prepareId,
        signature: signed.signature,
        walletAddress: signed.walletAddress,
      });
      return {
        submission: summarizeSubmittedSignalContainer(submission),
        ...(input.includeRaw ? { rawSubmission: submission } : {}),
      };
    },
    uvp_get_proof: async (input) => {
      const submission = await getSignalContainerProof({
        ...clientOptions,
        submissionId: input.submissionId,
      });
      return {
        submission: summarizeSubmittedSignalContainer(submission),
        ...(input.includeRaw ? { rawSubmission: submission } : {}),
      };
    },
    uvp_doctor: async (input) => {
      return runProductDoctor({
        ...clientOptions,
        ...input,
      });
    },
  };
}

function productMcpClientOptions(options: ProductMcpAdapterOptions): ProductApiClientOptions {
  return {
    chainServicesUrl: options.chainServicesUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.principalId ? { principalId: options.principalId } : {}),
  };
}
