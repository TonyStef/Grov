import { redirect } from 'next/navigation';

export default function HomePage() {
  // Redirect to dashboard (auth check happens in middleware/proxy)
  redirect('/dashboard');
}
