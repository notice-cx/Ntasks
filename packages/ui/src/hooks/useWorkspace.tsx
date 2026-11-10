/**
 * The workspace the pages work in, and the reads and writes about workspaces,
 * their projects and their members. `WorkspaceGate` chooses the workspace and
 * provides it; every task read below it is made in that workspace.
 */
import { useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { useTasksApi } from '../api/context';
import type {
  ConnectedApp,
  GitHubWebhook,
  GitHubWebhookSettings,
  NewApp,
  NewInvitation,
  NewProject,
  Workspace,
  WorkspaceMembers,
} from '../api/types';

/** The reads about the sign-in itself, which stay when the workspace changes. */
export const WORKSPACES_KEY = ['workspaces'] as const;
export const ACCOUNT_KEY = ['account'] as const;
const MEMBERS_KEY = ['members'] as const;
const APPS_KEY = ['apps'] as const;
const GITHUB_KEY = ['github'] as const;

/** Whether a cached read belongs to the workspace open now, so a switch drops it. */
export function inWorkspace(query: Query): boolean {
  const [head] = query.queryKey;
  return head !== WORKSPACES_KEY[0] && head !== ACCOUNT_KEY[0];
}

export interface OpenWorkspace {
  workspace: Workspace;
  workspaces: readonly Workspace[];
  /** Opens another workspace: the pages read everything again in it. */
  switchTo: (workspaceId: string) => void;
}

export const WorkspaceContext = createContext<OpenWorkspace | null>(null);

export function useWorkspace(): OpenWorkspace {
  const open = useContext(WorkspaceContext);
  if (!open) throw new Error('useWorkspace needs a WorkspaceGate around it.');
  return open;
}

/** Whether the sign-in owns the open workspace, and so manages its members and projects. */
export function useIsOwner(): boolean {
  return useWorkspace().workspace.role === 'owner';
}

export function useWorkspaceList() {
  const api = useTasksApi();
  return useQuery<readonly Workspace[]>({
    queryKey: WORKSPACES_KEY,
    queryFn: ({ signal }) => api.workspaces(signal),
    staleTime: 60_000,
  });
}

/** Who is signed in. Read only while it decides something, such as the first step of a sign-in with no workspace. */
export function useAccount(enabled: boolean) {
  const api = useTasksApi();
  return useQuery({
    queryKey: ACCOUNT_KEY,
    queryFn: ({ signal }) => api.account(signal),
    staleTime: Infinity,
    enabled,
  });
}

/** Saves the time zone the person chose, or null for their browser's; the pages show dates in it at once. */
export function useSetTimeZone() {
  const api = useTasksApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (timeZone: string | null) => api.setTimeZone(timeZone),
    onSuccess: (account) => client.setQueryData(ACCOUNT_KEY, account),
  });
}

export function useCreateWorkspace() {
  const api = useTasksApi();
  return useMutation({
    mutationFn: ({ name, idempotencyKey }: { name: string; idempotencyKey: string }) =>
      api.createWorkspace(name, { idempotencyKey }),
  });
}

/**
 * Renames a workspace. The answer goes into the workspace list at once, so the
 * sidebar and the switcher show the new name before the list is read again.
 */
export function useRenameWorkspace() {
  const api = useTasksApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, name }: { workspaceId: string; name: string }) =>
      api.renameWorkspace(workspaceId, name),
    onSuccess: (renamed) => {
      client.setQueryData<readonly Workspace[]>(WORKSPACES_KEY, (known = []) =>
        known.map((row) => (row.workspaceId === renamed.workspaceId ? renamed : row)),
      );
      return client.invalidateQueries({ queryKey: WORKSPACES_KEY });
    },
  });
}

/** Creates a project; the project list and the boards are read again, so it shows in the sidebar too. */
export function useCreateProject() {
  const api = useTasksApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: NewProject; idempotencyKey: string }) =>
      api.createProject(input, { idempotencyKey }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['task-projects'] }),
  });
}

/** An owner's setting of whether a project's changes go live by a deploy. */
export function useSetDeploys() {
  const api = useTasksApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ project, deploys }: { project: string; deploys: boolean }) => api.setDeploys(project, deploys),
    // The Waiting for you view lists merged work by this setting.
    onSettled: () => client.invalidateQueries({ queryKey: ['task-projects'] }),
  });
}

/** The members and pending invitations, for an owner: nobody else may read them. */
export function useMembers(enabled: boolean) {
  const api = useTasksApi();
  return useQuery<WorkspaceMembers>({
    queryKey: MEMBERS_KEY,
    queryFn: ({ signal }) => api.members(signal),
    staleTime: 15_000,
    enabled,
  });
}

/** One write to the member list, which is read again once it lands. */
function useMembersWrite<Input>(send: (input: Input) => Promise<void>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => client.invalidateQueries({ queryKey: MEMBERS_KEY }),
  });
}

export function useInvite() {
  const api = useTasksApi();
  return useMembersWrite(({ input, idempotencyKey }: { input: NewInvitation; idempotencyKey: string }) =>
    api.invite(input, { idempotencyKey }),
  );
}

export function useRevokeInvitation() {
  const api = useTasksApi();
  return useMembersWrite((invitationId: string) => api.revokeInvitation(invitationId));
}

export function useRemoveMember() {
  const api = useTasksApi();
  return useMembersWrite((userId: string) => api.removeMember(userId));
}

/** The open workspace's connected apps, each with whether the person signed in to it. */
export function useApps() {
  const api = useTasksApi();
  return useQuery<ConnectedApp[]>({
    queryKey: APPS_KEY,
    queryFn: ({ signal }) => api.apps(signal),
    staleTime: 15_000,
  });
}

/** One write to the app list, which is read again once it lands. */
function useAppsWrite<Input, Output>(send: (input: Input) => Promise<Output>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => client.invalidateQueries({ queryKey: APPS_KEY }),
  });
}

export function useRegisterApp() {
  const api = useTasksApi();
  return useAppsWrite(({ input, idempotencyKey }: { input: NewApp; idempotencyKey: string }) =>
    api.registerApp(input, { idempotencyKey }),
  );
}

export function useRevokeApp() {
  const api = useTasksApi();
  return useAppsWrite((clientId: string) => api.revokeApp(clientId));
}

export function useRemoveApp() {
  const api = useTasksApi();
  return useAppsWrite((clientId: string) => api.removeApp(clientId));
}

/** The open workspace's GitHub webhook, which only its owners read. */
export function useGitHubWebhook() {
  const api = useTasksApi();
  return useQuery<GitHubWebhook>({
    queryKey: GITHUB_KEY,
    queryFn: ({ signal }) => api.githubWebhook(signal),
    staleTime: 15_000,
  });
}

/** Saves the webhook's secret, its deploy checks or both, and keeps the saved webhook as the read. */
export function useSaveGitHubWebhook() {
  const api = useTasksApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: GitHubWebhookSettings) => api.saveGitHubWebhook(settings),
    onSuccess: (saved) => client.setQueryData(GITHUB_KEY, saved),
  });
}

/** Removes the webhook, then reads it again. */
export function useRemoveGitHubWebhook() {
  const api = useTasksApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.removeGitHubWebhook(),
    onSuccess: () => client.invalidateQueries({ queryKey: GITHUB_KEY }),
  });
}

/** Starts Connect GitHub: the browser then posts the manifest to GitHub, which makes the app. */
export function useConnectGitHub() {
  const api = useTasksApi();
  return useMutation({ mutationFn: () => api.connectGitHub() });
}

/** Forgets the workspace's GitHub App, then reads the connection again. */
export function useDisconnectGitHub() {
  const api = useTasksApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.disconnectGitHub(),
    onSuccess: () => client.invalidateQueries({ queryKey: GITHUB_KEY }),
  });
}

/** Counts a detected deploy check, or switches it off, and keeps the answer as the read. */
export function useSetDeployCheck() {
  const api = useTasksApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, on }: { name: string; on: boolean }) => api.setDeployCheck(name, on),
    onSuccess: (saved) => client.setQueryData(GITHUB_KEY, saved),
  });
}
