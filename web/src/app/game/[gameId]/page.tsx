import { ComTowerApp } from '../../page';

export default function GamePage({ params }: { params: { gameId: string } }) {
  return <ComTowerApp initialGameId={params.gameId} />;
}

