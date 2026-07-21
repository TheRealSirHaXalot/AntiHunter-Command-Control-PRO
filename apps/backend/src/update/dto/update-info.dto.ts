export class UpdateInfoDto {
  available!: boolean;
  currentCommit!: string;
  currentBranch?: string;
  remote?: string;
  remoteBranch?: string;
  latestCommit?: string;
  commitsBehind?: number;
  commitsAhead?: number;
  lastCommitMessage?: string;
  lastCommitDate?: string;
  lastCommitAuthor?: string;
  localCommitMessage?: string;
  localCommitDate?: string;
  localCommitAuthor?: string;
  remoteCommitMessage?: string;
  remoteCommitDate?: string;
  remoteCommitAuthor?: string;
  lastCheckAt!: string;
  canUpdate!: boolean;
  blockers?: string[];
  warning?: string;
}

export class GitRemoteDto {
  name!: string;
  url!: string;
  isDefault!: boolean;
}
