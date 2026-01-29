import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog');

  return rss({
    title: 'Grov Blog',
    description: 'Engineering insights, product updates, and tutorials on AI memory, Claude Code optimization, and developer productivity.',
    site: context.site ?? 'https://grov.dev',
    items: posts
      .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
      .map((post) => ({
        title: post.data.title,
        pubDate: post.data.pubDate,
        description: post.data.description,
        author: post.data.author,
        link: `/blog/${post.slug}/`,
      })),
    customData: `<language>en-us</language>`,
  });
}
