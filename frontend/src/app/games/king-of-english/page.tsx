import { AuthGuard } from '@/components/common/AuthGuard';
import { KingGame } from '@/components/features/games/king-of-english/KingGame';

export default function KingOfEnglishPage() {
  return <AuthGuard><KingGame /></AuthGuard>;
}
