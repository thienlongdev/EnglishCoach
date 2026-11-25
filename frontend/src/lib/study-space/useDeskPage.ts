'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};
const inComputer = () => !!window.frameElement?.hasAttribute('data-echo-desk-page');

/** A page inside a Study Space computer has its own viewport. This marker
 * only selects presentation. Account scoping stays with the normal providers. */
export const useDeskPage = () => useSyncExternalStore(subscribe, inComputer, () => false);

