import { PUBLIC_PAGES, type PublicPath } from '@/lib/discover/pages';
import { StructuredData } from './StructuredData';

export function Guide({ path, children }: { path: PublicPath; children: React.ReactNode }) {
  const hub = '/huong-dan';
  const paths: PublicPath[] = path === hub ? ['/', hub] : ['/', hub, path];
  return <article lang="vi" data-discover-document="" className="mx-auto w-full max-w-3xl px-6 py-12 text-slate-100 sm:py-20
    [&_h1]:mb-6 [&_h1]:text-4xl [&_h1]:font-bold [&_h1]:leading-tight
    [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-2xl [&_h2]:font-bold
    [&_p]:my-4 [&_p]:leading-8 [&_li]:mb-2 [&_li]:leading-7 [&_ul]:list-disc [&_ul]:pl-6
    [&_a]:text-cyan-200 [&_a]:underline [&_a]:underline-offset-4 [&_summary]:cursor-pointer">
    <StructuredData paths={paths} />
    <nav aria-label="Đường dẫn" className="mb-9 text-sm">
      <ol className="flex flex-wrap gap-x-3">{paths.map((item, index) =>
        <li key={item}>{index < paths.length - 1
          ? <><a href={item}>{PUBLIC_PAGES[item].title}</a><span aria-hidden="true"> /</span></>
          : <span aria-current="page">{PUBLIC_PAGES[item].title}</span>}</li>)}</ol>
    </nav>
    <h1>{PUBLIC_PAGES[path].title}</h1>
    {children}
  </article>;
}
