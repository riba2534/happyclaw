import type { ReactNode } from 'react';
import { LazyMotion, MotionConfig } from 'motion/react';

const loadFeatures = () => import('./motion-features').then((m) => m.default);

/** Shared easing/durations; mirror the CSS --ease-snappy token. */
export const EASE_SNAPPY = [0.16, 1, 0.3, 1] as const;
export const DURATION = { micro: 0.1, fast: 0.15, standard: 0.2 } as const;

/**
 * App-wide motion setup: features load on demand, `strict` forbids the heavy
 * `motion.*` components (use `m.*`), and animations honour the OS
 * reduced-motion setting.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig
        reducedMotion="user"
        transition={{ duration: DURATION.fast, ease: EASE_SNAPPY }}
      >
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
