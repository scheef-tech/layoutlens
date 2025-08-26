export type Shot = {
  locale: string;
  breakpoint: number;
  path: string;
  width: number;
  height: number;
  ok: boolean;
  error?: string;
};

export type RunManifest = {
  id: string;
  url: string;
  breakpoints: number[];
  locales: string[];
  cookie: {
    name: string;
    domain?: string;
    path?: string;
    sameSite?: 'Lax' | 'Strict' | 'None';
    secure?: boolean;
    httpOnly?: boolean;
  };
  behavior: {
    sendAcceptLanguage?: boolean;
    urlTemplate?: string | null;
    useUrlTemplate?: boolean;
  };
  out_dir: string;
  shots: Shot[];
};


