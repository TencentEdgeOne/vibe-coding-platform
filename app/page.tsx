import { WorkspaceScreen } from './features/workspace/workspace-screen';

/** Route boundary stays server-rendered; all interactive state is feature-local. */
export default function Home() {
  return <WorkspaceScreen />;
}
