export function FieldError({ id, children }: { id: string; children: string | undefined }) {
  if (!children) return null;
  return (
    <span id={id} className="mt-1 block text-xs text-danger">
      {children}
    </span>
  );
}
