// API route to proxy device authorization from dashboard to API server
// This allows the dashboard to authorize CLI devices on behalf of the logged-in user

import { getAuthSession } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

// API server URL
const API_URL = process.env.API_URL || 'http://localhost:3001';

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthSession();
    if (!auth) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated. Please log in first.' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { user_code } = body;

    if (!user_code) {
      return NextResponse.json(
        { success: false, error: 'User code is required' },
        { status: 400 }
      );
    }

    const apiResponse = await fetch(`${API_URL}/auth/device/${user_code}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.accessToken}`,
      },
      body: JSON.stringify({ user_code }),
    });

    const data = await apiResponse.json();

    return NextResponse.json(data, { status: apiResponse.status });
  } catch (err) {
    console.error('Device authorization error:', err);
    return NextResponse.json(
      { success: false, error: 'Failed to authorize device' },
      { status: 500 }
    );
  }
}
