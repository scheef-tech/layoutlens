import type { PageSelection } from "./types";

export type FigmaWriteResult = {
  status: "success" | "skipped" | "failed";
  message: string;
};

type CreateOrUpdateFrameInput = {
  fileKey: string;
  selection: PageSelection;
  artifactUrl?: string;
  nodeId?: string;
};

export class FigmaApiClient {
  private readonly token: string | undefined;

  public constructor(token = process.env.FIGMA_TOKEN) {
    this.token = token;
  }

  public async verifyFileAccess(fileKey: string): Promise<void> {
    if (!this.token) {
      return;
    }
    const response = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
      headers: {
        "X-Figma-Token": this.token
      }
    });

    if (!response.ok) {
      throw new Error(`Figma file lookup failed: ${response.status} ${response.statusText}`);
    }
  }

  public async createOrUpdateFrame(input: CreateOrUpdateFrameInput): Promise<FigmaWriteResult> {
    const mode = process.env.FIGMA_WRITE_MODE?.trim() || "dev_resources";
    if (!this.token) {
      return {
        status: "skipped",
        message: "No FIGMA_TOKEN set; ran as dry-run."
      };
    }

    await this.verifyFileAccess(input.fileKey);

    if (mode !== "dev_resources") {
      return {
        status: "skipped",
        message: `FIGMA_WRITE_MODE=${mode} is not supported.`
      };
    }

    const nodeId = input.nodeId || process.env.FIGMA_TARGET_NODE_ID;
    if (!nodeId) {
      return {
        status: "skipped",
        message: "No figmaNodeId provided; skipping Figma write."
      };
    }
    if (!input.artifactUrl) {
      return {
        status: "skipped",
        message: "No artifact URL available for Figma write."
      };
    }

    const response = await fetch("https://api.figma.com/v1/dev_resources", {
      method: "POST",
      headers: {
        "X-Figma-Token": this.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        file_key: input.fileKey,
        node_id: nodeId,
        name: `${input.selection.routeKey} · ${input.selection.locale} · ${input.selection.breakpoint}`,
        url: input.artifactUrl
      })
    });

    if (!response.ok) {
      const reason = await safeReadBody(response);
      return {
        status: "failed",
        message: `Figma dev resource write failed (${response.status}): ${reason}`
      };
    }

    return {
      status: "success",
      message: `Linked artifact on node ${nodeId} for ${input.selection.routeKey} (${input.selection.locale}/${input.selection.breakpoint}).`
    };
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return response.statusText;
  }
}
