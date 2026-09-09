import { runFileReadPipeline } from './_pipelines.ts';

export async function onRequest(context: any) {
  return runFileReadPipeline(context);
}
