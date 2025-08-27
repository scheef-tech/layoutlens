declare module "panzoom" {
  // Minimal typings for panzoom used in our gallery
  export type PanZoom = {
    dispose(): void;
    on(event: string, cb: (...args: any[]) => void): void;
    smoothZoomAbs(x: number, y: number, scale: number): void;
    zoomAbs(x: number, y: number, scale: number): void;
    moveBy(dx: number, dy: number, smooth?: boolean): void;
    moveTo(x: number, y: number): void;
    getTransform(): { x: number; y: number; scale: number };
    setTransform(x: number, y: number, scale: number): void;
    resume(): void;
    pause(): void;
  };

  export default function panzoom(el: HTMLElement, opts?: any): PanZoom;
}
