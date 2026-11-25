import {AuthGuard} from '@/components/common/AuthGuard';
import SpellingGame from '@/components/features/games/echo-spelling/SpellingGame';
export const metadata={title:'Echo Spelling',description:'Nghe, đánh vần và chinh phục sân khấu Echo Ocean. Solo và thi đấu nhiều người.'};
export default function EchoSpellingPage(){return <AuthGuard><SpellingGame/></AuthGuard>;}
