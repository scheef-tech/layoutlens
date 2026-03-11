import { getEnv, getEnvInt } from "./env";

export type FigmaProject = {
  id: string;
  name: string;
};

export type FigmaProjectFile = {
  key: string;
  name: string;
  lastModified?: string;
};

export class FigmaApiClient {
  private readonly token: string | undefined;

  public constructor(token = getEnv("FIGMA_TOKEN")) {
    this.token = token;
  }

  public async listTeamProjects(teamId: string): Promise<FigmaProject[]> {
    this.ensureToken();
    const response = await this.fetchWithTimeout(
      `https://api.figma.com/v1/teams/${encodeURIComponent(teamId)}/projects`,
      {
        headers: {
          "X-Figma-Token": this.token!
        }
      }
    );
    if (!response.ok) {
      throw new Error(`Figma team projects lookup failed: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as { projects?: Array<{ id: string; name: string }> };
    return (json.projects || []).map((project) => ({
      id: project.id,
      name: project.name
    }));
  }

  public async listProjectFiles(projectId: string): Promise<FigmaProjectFile[]> {
    this.ensureToken();
    const response = await this.fetchWithTimeout(
      `https://api.figma.com/v1/projects/${encodeURIComponent(projectId)}/files`,
      {
        headers: {
          "X-Figma-Token": this.token!
        }
      }
    );
    if (!response.ok) {
      throw new Error(`Figma project files lookup failed: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as {
      files?: Array<{ key: string; name: string; last_modified?: string }>;
    };
    return (json.files || []).map((file) => ({
      key: file.key,
      name: file.name,
      lastModified: file.last_modified
    }));
  }


  private ensureToken(): void {
    if (!this.token) {
      throw new Error("FIGMA_TOKEN is required for this operation.");
    }
  }


  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = getEnvInt("FIGMA_API_TIMEOUT_MS", 30000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
