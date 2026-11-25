'use client';

import React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { BrandWhaleIcon } from '@/components/common/BrandWhaleIcon';

interface FooterLink {
  label: string;
  href: string;
}

/** Opens the learner feedback modal of the app shell (TopNavbar reads `feedback=open` once). */
export const FEEDBACK_HREF = '/dashboard?feedback=open';

// Only routes that exist in the app tree — no placeholder links. No public legal / help pages exist yet, so no
// "Pháp lý" group: add it together with the real pages.
const LEARNING_LINKS: FooterLink[] = [
  { label: 'Hướng dẫn tự học', href: '/huong-dan' },
  { label: 'Từ vựng', href: '/flashcards' },
  { label: 'Đọc', href: '/reading' },
  { label: 'Nghe', href: '/listening' },
  { label: 'Nói', href: '/speaking' },
  { label: 'Viết', href: '/writing' },
  { label: 'Thi thử', href: '/exams' },
];

const PRODUCT_LINKS: FooterLink[] = [
  { label: 'AI Echo', href: '/dashboard' },
  { label: 'Bảng xếp hạng', href: '/leaderboard' },
  { label: 'Cộng đồng', href: '/community' },
  { label: 'Premium', href: '/premium' },
  { label: 'Echo Anywhere', href: '/echo-anywhere' },
];

function FooterGroup({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div className="space-y-3">
      <h2 className="text-xs font-bold text-white uppercase tracking-wider">{title}</h2>
      <ul className="space-y-2 text-xs">
        {links.map((link) => (
          <li key={link.label}>
            <Link prefetch={false} href={link.href} className="hover:text-cyan-300 transition-colors">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LandingFooter() {
  const { data: session } = useSession();
  const supportLinks: FooterLink[] = [
    {
      label: 'Gửi phản hồi và báo lỗi',
      href: session?.user ? FEEDBACK_HREF : `/login?callbackUrl=${encodeURIComponent(FEEDBACK_HREF)}`,
    },
    { label: 'Khôi phục mật khẩu', href: '/forgot-password' },
  ];

  return (
    <footer className="w-full border-t border-sky-200/10 bg-[#030c26]/85 text-slate-400 text-xs shadow-[inset_0_1px_0_rgba(125,211,252,0.08)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 space-y-8">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8">

          {/* Brand Info */}
          <div className="space-y-3 col-span-2">
            <div className="flex items-center gap-2.5">
              <BrandWhaleIcon variant="clean" size="sm" className="h-8 w-8 drop-shadow-[0_2px_8px_rgba(56,189,248,0.35)]" />
              <span className="text-base font-black text-white tracking-tight">
                English<span className="text-cyan-300">Coach</span>
              </span>
            </div>
            <p className="text-slate-400 text-xs max-w-sm leading-relaxed">
              Echo English Coach là nền tảng tự học tiếng Anh cho người Việt. Bạn có thể bắt đầu bằng{' '}
              <Link prefetch={false} className="underline hover:text-cyan-300" href="/huong-dan/nghe-chep-chinh-ta">bài nghe chép chính tả</Link>
              {' '}hoặc <Link prefetch={false} className="underline hover:text-cyan-300" href="/huong-dan/hoc-tu-trong-ngu-canh">bài tập đoán nghĩa của từ</Link>.
              {' '}Cả hai bài đều có đáp án để tự kiểm tra.
            </p>
          </div>

          <FooterGroup title="Học tập" links={LEARNING_LINKS} />
          <FooterGroup title="Sản phẩm" links={PRODUCT_LINKS} />
          <FooterGroup title="Hỗ trợ" links={supportLinks} />

        </div>

        {/* Subtle Bottom Credit Line */}
        <div className="pt-6 border-t border-slate-900 flex flex-col sm:flex-row items-center justify-between text-[11px] text-slate-400 gap-2 text-center sm:text-left">
          <div className="space-y-1">
            <div>© 2026 EnglishCoach. All rights reserved.</div>
            <div>EnglishCoach · Học thông minh hơn mỗi ngày</div>
          </div>
          {/* CC BY 4.0 requires attribution — keep it visible */}
          <span className="text-[10px] text-slate-400">
            3D Mascot: Low poly animated Cartoon Whale by Blue Colossus Studio (CC BY 4.0).
          </span>
        </div>
      </div>
    </footer>
  );
}
