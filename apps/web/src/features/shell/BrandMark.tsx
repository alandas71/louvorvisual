import Image from 'next/image';

/** Marca oficial do aplicativo. É decorativa: o texto ao lado traz o nome. */
export function BrandMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <Image
      src="/brand/louvorvisual-mark.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={className}
    />
  );
}
