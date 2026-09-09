import {
  createProjectResumeStreamResponse,
  runProjectResumePipeline,
} from './_pipelines.ts';

/** Progressive initial restore: history and workspace arrive on one SSE request. */
export async function onRequestGet(context: any) {
  return createProjectResumeStreamResponse(context);
}

/** Explicit preview refresh and compatibility stages remain JSON POST actions. */
export async function onRequestPost(context: any) {
  return runProjectResumePipeline(context);
}
