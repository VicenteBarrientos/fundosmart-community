import Image from "next/image";

type FundoSmartLogoProps = {
  className?: string;
  height?: number;
  inverse?: boolean;
};

// Intrinsic proportions of the horizontal mark + wordmark lockup.
const ASPECT_RATIO = 1024 / 276;

export function FundoSmartLogo({ className = "", height = 40, inverse = false }: FundoSmartLogoProps) {
  return (
    <Image
      alt="FundoSmart"
      className={className}
      height={height}
      src={inverse ? "/fundosmart-ultra-min-logo-inverse.svg" : "/fundosmart-ultra-min-logo.svg"}
      unoptimized
      width={Math.round(height * ASPECT_RATIO)}
    />
  );
}
