import { AuthGuard } from '@/components/common/AuthGuard';
import RushGame from '@/components/features/games/echo-quiz-rush/RushGame';
export const metadata = { description: 'Chạy qua những cổng tri thức trên đường đua cùng Echo.' };
export default function EchoQuizRushPage() { return <AuthGuard><RushGame/></AuthGuard>; }
