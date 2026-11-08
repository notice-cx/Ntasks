/**
 * The workspace the pages work in, and the reads and writes about workspaces,
 * their projects and their members. `WorkspaceGate` chooses the workspace and
 * provides it; every task read below it is made in that workspace.
 */
import { useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { useTasksApi } from '@/api/context';
import type { NewInvitation, NewProject, Workspace, WorkspaceMembers } from '@/api/types';

/** The reads about the sign-in itself, which stay when the workspace changes. */
export const WORKSPACES_KEY = ['workspaces'] as const;
export const ACCOUNT_KEY = ['account'] as const;
const MEMBERS_KEY = ['members'] as const;

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

export function useCreateWorkspace() {
  const api = useTasksApi();
  return useMutation({
    mutationFn: ({ name, idempotencyKey }: { name: string; idempotencyKey: string }) =>
      api.createWorkspace(name, { idempotencyKey }),
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
