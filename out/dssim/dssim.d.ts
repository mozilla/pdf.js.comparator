/* tslint:disable */
/* eslint-disable */

export class DssimResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly heatmap: Uint8Array;
    readonly score: number;
}

export function compare(a: Uint8Array, b: Uint8Array, width: number, height: number): DssimResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_dssimresult_free: (a: number, b: number) => void;
    readonly compare: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly dssimresult_heatmap: (a: number) => [number, number];
    readonly dssimresult_score: (a: number) => number;
    readonly dssim_compare: (a: number, b: number, c: number) => number;
    readonly dssim_create_image_rgb: (a: number, b: number, c: number, d: number) => number;
    readonly dssim_create_image_rgba: (a: number, b: number, c: number, d: number) => number;
    readonly dssim_free: (a: number) => void;
    readonly dssim_free_image: (a: number) => void;
    readonly dssim_new: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
