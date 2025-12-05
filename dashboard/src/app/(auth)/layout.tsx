export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-0 grain">
      <div className="w-full max-w-md p-6">{children}</div>
    </div>
  );
}
