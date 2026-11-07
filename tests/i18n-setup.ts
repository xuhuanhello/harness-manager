import { beforeEach } from 'vitest';
import { setLocaleResolver } from '../src/shared/i18n';

// Existing service fixtures deliberately exercise Simplified Chinese messages.
beforeEach(() => setLocaleResolver(() => 'zh-CN'));
