type FundoSmartShieldProps = {
  className?: string;
  size?: number;
};

export function FundoSmartShield({ className = "size-6", size = 24 }: FundoSmartShieldProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="18"
      viewBox="0 0 512 512"
      width={size}
    >
      <path d="M 256 68 L 408 136 C 424 280, 392 384, 256 444 C 120 384, 88 280, 104 136 Z" />
      <path d="M 186 206 L 224 164 L 288 164 L 326 206" />
      <path d="M 186 206 L 214 314" />
      <path d="M 326 206 L 298 314" />
      <path d="M 186 206 L 224 232 L 224 302" />
      <path d="M 326 206 L 288 232 L 288 302" />
      <path d="M 224 302 L 288 302 M 224 302 C 210 308, 206 322, 216 338 L 238 358 C 248 366, 264 366, 274 358 L 296 338 C 306 322, 302 308, 288 302" />
      <path d="M 186 206 C 154 184, 120 188, 108 202 C 120 230, 160 244, 192 238" />
      <path d="M 326 206 C 358 184, 392 188, 404 202 C 392 230, 352 244, 320 238" />
    </svg>
  );
}
