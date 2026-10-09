// Loaded lazily by MotionProvider so animation features stay out of the
// entry chunk. domAnimation (15KB gz) rather than domMax (29KB gz): nothing
// uses drag, and layout animation only slid reordered sidebar sessions.
import { domAnimation } from 'motion/react';

export default domAnimation;
