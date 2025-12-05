import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * Validates that a redirect path is safe (internal only)
 * Prevents open redirect attacks via the 'next' parameter
 */
function isValidRedirectPath(path: string): boolean {
  // Must start with / (relative path)
  if (!path.startsWith('/')) return false;
  // Must not start with // (protocol-relative URL to external site)
  if (path.startsWith('//')) return false;
  // Must not contain :// (absolute URL)
  if (path.includes('://')) return false;
  // Must not contain backslash (URL encoding bypass)
  if (path.includes('\\')) return false;
  return true;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const nextParam = searchParams.get('next') ?? '/dashboard';

  // Validate redirect path to prevent open redirect attacks
  const next = isValidRedirectPath(nextParam) ? nextParam : '/dashboard';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Return the user to an error page with instructions
  return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
}
