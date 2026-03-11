export type Breakpoint = number;

export type PageSelection = {
  url: string;
  routeKey: string;
  locale: string;
  breakpoint: Breakpoint;
};

export type DiscoverSitemapRequest = {
  baseUrl: string;
  maxUrls?: number;
  maxSitemaps?: number;
};

export type DiscoverSitemapResponse = {
  sourceSitemaps: string[];
  pageUrls: string[];
  discoveredLocales: string[];
  routeGroups: Array<{
    id: string;
    displayPath: string;
    locales: Record<string, string>;
  }>;
};

export type CreateJobRequest = {
  figmaFileKey?: string;
  pages: string[];
  locales: string[];
  targets?: Array<{
    url: string;
    locale: string;
    routeKey?: string;
  }>;
  breakpoints: Breakpoint[];
  localeCookie?: {
    name: string;
    domain?: string;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
    httpOnly?: boolean;
  };
  sendAcceptLanguage?: boolean;
};

export type JobStatus = "queued" | "running" | "success" | "failed";

export type JobTaskResult = {
  page: string;
  routeKey?: string;
  locale: string;
  breakpoint: Breakpoint;
  status: "success" | "skipped" | "failed";
  message: string;
  artifactPath?: string;
};

export type ImportJob = {
  id: string;
  accessToken?: string;
  figmaFileKey: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  summary: {
    total: number;
    completed: number;
    failed: number;
  };
  selections: PageSelection[];
  warnings: string[];
  tasks: JobTaskResult[];
  runDir: string;
};
