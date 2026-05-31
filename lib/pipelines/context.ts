/**
 * Shared execution context for the headless test-generation pipelines.
 *
 * Replaces the source app's `PipelineContext` / `RegressionPipelineContext`,
 * which carried SSE emitters and human-gate callbacks (askQuestion,
 * requestPromptApproval, requestPlanApproval). None of those exist here:
 * the pipeline runs fully autonomously. The only side channel is `log`,
 * which both persists the active `stage` and writes a console line.
 */
export interface HeadlessContext {
  taskId: string;
  kind: "e2e" | "exploratory";
  inputText: string;
  targetUrl: string;
  acceptanceCriteria: { title: string; criteria: string } | null;
  applicationName: string;
  applicationUrl: string;
  applicationUsername: string;
  applicationPassword: string;
  repositoryUrl: string;
  repositoryProvider: string;
  outputFolder: string;
  repositoryPat: string;
  repositoryOrganization: string | null;
  log: (stage: string, message: string) => void;
}
