import { runProjectDownloadPipeline } from './_pipelines.ts';

export async function onRequest(context: any) {
  return runProjectDownloadPipeline(context);
}
