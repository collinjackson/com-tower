'use client';

import { use } from 'react';
import { ComTowerApp } from '../../page';

export default function GamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = use(params);
  return <ComTowerApp initialGameId={gameId} />;
}

