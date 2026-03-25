/**
 * Material Symbols (M3) Rounded icon wrapper.
 * Usage: <MIcon name="chat" size={20} />
 * Browse icons: https://fonts.google.com/icons
 */
interface MIconProps {
  name: string;
  size?: number;
  className?: string;
  filled?: boolean;
}

export function MIcon({ name, size = 20, className = '', filled = false }: MIconProps) {
  return (
    <span
      className={`material-symbols-rounded leading-none inline-flex items-center justify-center ${className}`}
      style={{
        fontSize: size,
        fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 300, 'GRAD' 0, 'opsz' ${size}`,
      }}
    >
      {name}
    </span>
  );
}
