// Rewrite `npm:pkg@version` to bare `pkg`, resolved relative to the importer.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('npm:')) {
    const rest = specifier.slice(4);
    const pkg = rest.startsWith('@')
      ? '@' + rest.slice(1).split('@')[0]
      : rest.split('@')[0];
    return nextResolve(pkg, context);
  }
  return nextResolve(specifier, context);
}
