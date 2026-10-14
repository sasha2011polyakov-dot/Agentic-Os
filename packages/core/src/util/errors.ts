/**
 * Stable error codes with user-facing messages, actionable hints and the guide page the UI links to
 * ("Open the guide"). Stack traces never reach the user — only the log.
 */
export const ERROR_CATALOG = {
  VALIDATION_FAILED: { status: 400, message: 'The data did not pass validation.', hint: 'Fix the highlighted fields and try again.', guide: undefined, retryable: false },
  NOT_FOUND: { status: 404, message: 'Not found.', hint: 'It may have been deleted or renamed. Refresh the list.', guide: undefined, retryable: false },
  PATH_INVALID: { status: 400, message: 'Invalid path or file name.', hint: 'Do not use the characters \\ : * ? " < > | or reserved names (CON, NUL…).', guide: 'notes-editing', retryable: false },
  PATH_OUTSIDE_SCOPE: { status: 403, message: 'The path is outside the allowed folders.', hint: 'Operations are allowed only inside connected vaults and folders you granted access to.', guide: 'permissions', retryable: false },
  SOURCE_NOT_ACCESSIBLE: { status: 409, message: 'The folder cannot be read.', hint: 'Check that the folder exists, the drive is connected and the app has read access.', guide: 'connect-folder', retryable: true },
  SOURCE_ALREADY_CONNECTED: { status: 409, message: 'This folder is already connected.', hint: 'Open it in "Projects".', guide: 'connect-folder', retryable: false },
  SOURCE_OVERLAP: { status: 409, message: 'The folder overlaps an already connected source.', hint: 'Nested and parent folders are not connected twice, so files are not indexed twice. Change the exclusion rules of the existing source or disconnect it.', guide: 'connect-folder', retryable: false },
  READ_ONLY_SOURCE: { status: 403, message: 'The source is connected read-only.', hint: 'The app does not change files of connected projects. Create documents in the vault.', guide: 'connect-folder', retryable: false },
  WRITE_CONFLICT: { status: 409, message: 'The file was changed outside the app after it was opened.', hint: 'Compare the versions and choose which one to keep. Your changes are not lost.', guide: 'notes-editing', retryable: false },
  FILE_TOO_LARGE: { status: 413, message: 'The file is too large to process.', hint: 'Raise the size limit in the source settings or exclude the file.', guide: 'indexing', retryable: false },
  PERMISSION_DENIED: { status: 403, message: 'The agent does not have permission for this action.', hint: 'Grant the permission on the agent card ("Agents" → "Permissions") or narrow the task.', guide: 'permissions', retryable: false },
  AGENT_NOT_ENABLED: { status: 409, message: 'The agent is not enabled.', hint: 'Enable the agent in "Agents" after reviewing its permissions and a test run.', guide: 'install-agent', retryable: false },
  AGENT_PACKAGE_INVALID: { status: 400, message: 'The agent package is damaged or does not match the format.', hint: 'Check manifest.json and the schemas against the package format description.', guide: 'create-agent', retryable: false },
  AGENT_INCOMPATIBLE: { status: 409, message: 'The agent package is not compatible with this version of the app.', hint: 'Update the app or install an agent version that supports the current platform.', guide: 'install-agent', retryable: false },
  NO_MODEL_CONFIGURED: { status: 409, message: 'No AI model is configured.', hint: 'Connect a local model (Ollama or LM Studio) or a cloud provider in "Models".', guide: 'local-model', retryable: false },
  MODEL_UNAVAILABLE: { status: 503, message: 'The selected model is not available.', hint: 'Make sure the local engine is running and the model is installed, or choose another model for the agent.', guide: 'local-model', retryable: true },
  PROVIDER_UNREACHABLE: { status: 503, message: 'The AI provider does not respond.', hint: 'Check the provider address and that the service is running (Ollama: `ollama serve`, LM Studio: Developer tab → Start server).', guide: 'local-model', retryable: true },
  PROVIDER_AUTH_FAILED: { status: 401, message: 'The provider rejected the API key.', hint: 'Check the key and its access rights in the provider account, then replace the key in settings.', guide: 'ai-providers', retryable: false },
  PROVIDER_RATE_LIMITED: { status: 429, message: 'The provider rate limit was exceeded.', hint: 'Wait and try again, reduce parallelism or choose another model.', guide: 'ai-providers', retryable: true },
  PROVIDER_ERROR: { status: 502, message: 'The provider returned an error.', hint: 'Details are in the log. Try again or choose another model.', guide: 'troubleshooting', retryable: true },
  CONTEXT_TOO_LARGE: { status: 413, message: 'The context does not fit into the model window.', hint: 'Narrow the scope (fewer files) or choose a model with a larger context.', guide: 'spec-generation', retryable: false },
  STRUCTURED_OUTPUT_FAILED: { status: 422, message: 'The model could not return an answer in the required format.', hint: 'Models under ~7B parameters often fail structured output. Choose a stronger model for this agent.', guide: 'local-model', retryable: true },
  OFFLINE_MODE: { status: 409, message: 'Offline mode is on: the network request was blocked.', hint: 'Turn off offline mode in settings or use local models and data.', guide: 'offline-mode', retryable: false },
  NETWORK_POLICY_DENIED: { status: 403, message: 'The network request is not allowed by the policy.', hint: 'The "Local AI" mode forbids cloud requests. Change the mode in "Models" → "Routing".', guide: 'offline-mode', retryable: false },
  POLICY_CONFIDENTIAL_SOURCE: { status: 403, message: 'Data from a confidential source cannot be sent to a cloud model.', hint: 'Use a local model for this workflow or remove the "Confidential" mark from the source.', guide: 'permissions', retryable: false },
  BUDGET_EXCEEDED: { status: 402, message: 'The spending or request limit has been reached.', hint: 'The results so far are saved. Raise the limit in settings or continue with a local model.', guide: 'ai-providers', retryable: false },
  SECRET_STORE_UNAVAILABLE: { status: 409, message: 'The secure key store is not available.', hint: 'Set the key with the environment variable AOS_SECRET_<ID> or use the key for the current session only.', guide: 'ai-providers', retryable: false },
  WEB_SEARCH_NOT_CONFIGURED: { status: 409, message: 'No search provider is configured.', hint: 'Set the address of your SearXNG or a Brave Search key in "Settings" → "Web research". Direct URLs and GitHub work without setup.', guide: 'web-research', retryable: false },
  FETCH_BLOCKED: { status: 403, message: 'The address is blocked by the security policy.', hint: 'Loading local and internal addresses is forbidden to protect against SSRF.', guide: 'web-research', retryable: false },
  FETCH_FAILED: { status: 502, message: 'The page could not be loaded.', hint: 'Check the address and that the site is reachable.', guide: 'web-research', retryable: true },
  EXTRACTION_EMPTY: { status: 422, message: 'No text was found on the page.', hint: 'The site may build its content with JavaScript. Try another source.', guide: 'web-research', retryable: false },
  WORKFLOW_INVALID: { status: 400, message: 'The workflow definition contains errors.', hint: 'Fix the highlighted nodes and edges in the workflow editor.', guide: 'create-workflow', retryable: false },
  INVALID_STATE_TRANSITION: { status: 409, message: 'This status change is not allowed.', hint: 'Refresh the page: the state may have changed.', guide: undefined, retryable: false },
  DEPENDENCY_CYCLE: { status: 409, message: 'A dependency cycle was found.', hint: 'Remove one of the dependencies to break the cycle.', guide: 'tasks', retryable: false },
  CANCELLED: { status: 409, message: 'The operation was cancelled.', hint: 'Intermediate results are saved.', guide: undefined, retryable: true },
  TIMEOUT: { status: 504, message: 'The operation timed out.', hint: 'Raise the step timeout or choose a faster model.', guide: 'troubleshooting', retryable: true },
  BACKUP_FAILED: { status: 500, message: 'The backup could not be created.', hint: 'Check the free disk space and write access to the data folder.', guide: 'backup', retryable: true },
  INTEGRITY_CHECK_FAILED: { status: 500, message: 'The integrity check found problems.', hint: 'Run "Rebuild index" in settings. User files are not affected.', guide: 'recovery', retryable: false },
  SYSTEM_UNAVAILABLE: { status: 409, message: 'The knowledge system storage is not available.', hint: 'Check that the system folder exists and the drive is connected. If the folder was moved, point to the new location ("Locate folder"). No system data was deleted.', guide: 'systems', retryable: true },
  SYSTEM_DISCONNECTED: { status: 409, message: 'The knowledge system is disconnected.', hint: 'Reconnect it in "Systems" — the data is kept.', guide: 'systems', retryable: false },
  SYSTEM_ID_CONFLICT: { status: 409, message: 'A knowledge system with this ID is already registered.', hint: 'Open the existing system or connect this folder as a copy with a new ID.', guide: 'systems', retryable: false },
  SYSTEM_PATH_CONFLICT: { status: 409, message: 'The folder overlaps the storage of another knowledge system.', hint: 'Choose a separate folder: knowledge systems cannot be nested in each other.', guide: 'systems', retryable: false },
  SYSTEM_NOT_FOUND_AT_PATH: { status: 404, message: 'No Agentic OS knowledge system was found in the folder.', hint: 'Choose a folder that contains a .aos subfolder with system.json, or create a new system.', guide: 'systems', retryable: false },
  SYSTEM_HAS_ACTIVE_RUNS: { status: 409, message: 'Workflows are running in this knowledge system.', hint: 'Wait for them to finish, or pause or cancel them before this operation.', guide: 'systems', retryable: true },
  CONFIRMATION_REQUIRED: { status: 409, message: 'This operation needs explicit confirmation.', hint: 'Confirm the action in the dialog (to delete, type the exact name of the system).', guide: 'systems', retryable: false },
  ARCHIVE_INVALID: { status: 400, message: 'The system archive is damaged or has an unsupported format.', hint: 'Check that the file was created by an Agentic OS export and was not modified. Existing systems are not affected.', guide: 'backup', retryable: false },
  CROSS_SYSTEM_DENIED: { status: 403, message: 'Access to another knowledge system is not allowed for this run.', hint: 'Select the additional systems explicitly when starting the run and grant the agent the "Read other systems" permission.', guide: 'permissions', retryable: false },
  EXTENSION_INVALID: { status: 400, message: 'The extension did not pass validation and was not installed.', hint: 'See the list of reasons. Extensions never get dangerous privileges (writing to disk, running commands, secrets, changing security settings) and cannot contain executable code, except tool plugins.', guide: 'extensions', retryable: false },
  EXTENSION_DISABLED: { status: 409, message: 'The extension is disabled.', hint: 'Enable it in "Extensions" if you trust it.', guide: 'extensions', retryable: false },
  EXTENSION_BROKEN: { status: 409, message: 'The extension files were changed after installation.', hint: 'The extension is blocked: its files do not match the ones verified at installation. Reinstall it from a trusted source or remove it.', guide: 'extensions', retryable: false },
  APPLY_NOT_ALLOWED: { status: 403, message: 'Applying changes to this project is not allowed.', hint: 'Switch the project to the "Apply to the original project" mode on its card, or download the change set as a patch and apply it yourself.', guide: 'missions', retryable: false },
  CHECK_NOT_DEFINED: { status: 404, message: 'No check with this name is defined in the project settings.', hint: 'Add a check command (for example, running the tests) on the project card → "Checks".', guide: 'missions', retryable: false },
  CHECK_NOT_APPROVED: { status: 403, message: 'Running this check has not been approved for the mission.', hint: 'Approve the mission plan: it lists the checks that will run.', guide: 'missions', retryable: false },
  MODE_FORBIDS: { status: 403, message: 'The current project mode does not allow this action.', hint: 'Only the user changes the mode on the project card ("Read only" → "Prepare changes" → "Work in a copy" → "Apply to the original project").', guide: 'project-safety', retryable: false },
  REVIEW_REQUIRED: { status: 409, message: 'The changes must be reviewed before they are applied.', hint: 'Open "Review changes", look through the diff and mark the change set as reviewed.', guide: 'project-safety', retryable: false },
  REVIEW_STALE: { status: 409, message: 'The change set changed after your review.', hint: 'Review the changes again: the previous approval is no longer valid.', guide: 'project-safety', retryable: false },
  CHECKS_REQUIRED: { status: 409, message: 'The changes must pass the project checks in a work copy.', hint: 'Click "Check again": the changes are applied to a work copy and checked. The original project does not change.', guide: 'project-safety', retryable: false },
  WORKCOPY_FAILED: { status: 409, message: 'The work copy of the project could not be created.', hint: 'The original project was not changed. Check the free space and the project size, or work in the "Prepare changes" mode (patch).', guide: 'project-safety', retryable: true },
  COMMAND_BLOCKED: { status: 403, message: 'The command is blocked by the security policy.', hint: 'The app does not run unknown scripts, deletion commands, commands with elevated rights or Git commands that change the repository.', guide: 'project-safety', retryable: false },
  SECRET_EGRESS_BLOCKED: { status: 403, message: 'Sending was blocked: the data contains a secret.', hint: 'Values that look like keys and passwords are never sent to external services. Remove the secret from the document or use a local model.', guide: 'project-safety', retryable: false },
  UNAUTHORIZED: { status: 401, message: 'The session is not valid.', hint: 'Restart the app or open the link the server printed at startup.', guide: 'first-run', retryable: false },
  INTERNAL: { status: 500, message: 'Internal app error.', hint: 'The details are saved in the log ("History and log").', guide: 'troubleshooting', retryable: false },
} as const satisfies Record<string, { status: number; message: string; hint: string; guide: string | undefined; retryable: boolean }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface AppErrorJson {
  code: ErrorCode;
  message: string;
  hint: string;
  guide?: string;
  details?: unknown;
  retryable: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly guide: string | undefined;
  readonly details: unknown;
  readonly retryable: boolean;
  readonly status: number;

  constructor(code: ErrorCode, message?: string, opts: { hint?: string; details?: unknown; cause?: unknown; guide?: string } = {}) {
    const entry = ERROR_CATALOG[code];
    super(message ?? entry.message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.hint = opts.hint ?? entry.hint;
    this.guide = opts.guide ?? entry.guide;
    this.details = opts.details;
    this.retryable = entry.retryable;
    this.status = entry.status;
  }

  toJSON(): AppErrorJson {
    const out: AppErrorJson = { code: this.code, message: this.message, hint: this.hint, retryable: this.retryable };
    if (this.guide) out.guide = this.guide;
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Error && e.name === 'AbortError') return new AppError('CANCELLED', undefined, { cause: e });
  return new AppError('INTERNAL', undefined, { cause: e });
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AppError('CANCELLED');
}
