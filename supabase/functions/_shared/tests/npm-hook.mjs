// Registers a module-resolve hook that rewrites Deno-style `npm:pkg@version`
// specifiers to the locally installed package name, so the shared Edge
// Function modules can be imported by the Node test suite unchanged.
import { register } from 'node:module';
register('./npm-hook-impl.mjs', import.meta.url);
