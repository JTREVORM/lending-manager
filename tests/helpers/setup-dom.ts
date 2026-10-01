import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React Testing Library does not unmount automatically outside its own
// framework integrations, so without this each test inherits the previous
// test's DOM and queries start matching stale nodes.
afterEach(() => {
  cleanup();
});
