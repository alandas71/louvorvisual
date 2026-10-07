export function FieldError({ id, children }: { id: string; children: string | undefined }) {
  if (!children) return null;
  return (
    <span id={id} className="mt-1.5 block text-xs font-semibold text-danger">
      {children}
    </span>
  );
}
