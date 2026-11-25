'use client';
import {useSession} from 'next-auth/react';
import {useEffect} from 'react';
import dynamic from 'next/dynamic';
import { useModuleEntryScope } from '@/hooks/useModuleEntryResource';
const Arena=dynamic(()=>import('@/components/features/speaking/arena/ArenaExperience'),{ssr:false});
export default function SpeakingArenaPage(){const scope=useModuleEntryScope();const {status}=useSession();
  useEffect(()=>{if(status==='unauthenticated')location.replace('/login?callbackUrl='+encodeURIComponent(location.pathname+location.search));},[status]);
  return scope?<Arena key={scope}/>:null;}
