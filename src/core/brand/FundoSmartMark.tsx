import Image from "next/image";

type FundoSmartMarkProps = {
  className?: string;
  size?: number;
};

export function FundoSmartMark({ className = "", size = 32 }: FundoSmartMarkProps) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={className}
      height={size}
      src="/fundosmart-ultra-min-mark.svg"
      unoptimized
      width={size}
    />
  );
}
