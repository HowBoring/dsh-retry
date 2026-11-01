import type { Context } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'manual-retry': {
            readonly kind: 'manual-retry';
            readonly turn: number;
            readonly endSeq: number;
        };
    }
}
export interface ContinuationTarget {
    readonly turn: number;
    readonly endSeq: number;
    readonly reason: 'error' | 'user-aborted';
}
export declare const name = "retry";
export declare const inject: readonly ["commands", "sessionProjections"];
/** Host plugin: one `/retry` command and the Continuation projection it reads. */
export declare function apply(ctx: Context): void;
