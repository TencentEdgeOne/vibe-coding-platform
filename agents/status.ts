import { runStatusPipeline } from './pipelines/_status.ts';

/** Lightweight chat-task status for poll loops. */
export async function onRequestGet(context: any) {
  return runStatusPipeline(context);
}
