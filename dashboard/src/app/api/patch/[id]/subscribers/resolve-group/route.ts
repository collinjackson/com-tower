import { NextResponse, NextRequest } from 'next/server';
import { getAdminAuth, getAdminDb, adminAvailable } from '@/lib/firebase-admin';

/**
 * Resolve a group ID from an invite link or base64 part by querying the Signal bridge.
 * This is called when a group subscriber is added to look up the actual group ID.
 */
export async function POST(req: NextRequest) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const authHeader =
    req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const token = authHeader.slice('Bearer '.length);
    await getAdminAuth().verifyIdToken(token);
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  let body: {
    inviteLink?: string;
    base64Part?: string;
    groupName?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Extract base64 part from invite link if provided
  let base64Part: string | undefined = body.base64Part;
  if (body.inviteLink && !base64Part) {
    const match = body.inviteLink.match(/signal\.group\/#(.+)/);
    if (match && match[1]) {
      base64Part = match[1];
    } else if (body.inviteLink.startsWith('group.')) {
      base64Part = body.inviteLink.substring(6);
    } else if (!body.inviteLink.includes('/') && !body.inviteLink.includes('#')) {
      base64Part = body.inviteLink;
    }
  }

  if (!base64Part && !body.groupName) {
    return NextResponse.json({ error: 'Must provide inviteLink, base64Part, or groupName' }, { status: 400 });
  }

  // Call the worker's list-groups endpoint to resolve the group ID
  const workerUrl = process.env.COM_TOWER_WORKER_URL || 'https://com-tower-worker-33713971134.us-central1.run.app';
  
  try {
    const groupsRes = await fetch(`${workerUrl}/list-groups`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!groupsRes.ok) {
      const errData = await groupsRes.json().catch(() => ({}));
      return NextResponse.json(
        { error: `Failed to list groups: ${errData.error || groupsRes.statusText}` },
        { status: groupsRes.status }
      );
    }

    const data = await groupsRes.json();
    const groups = Array.isArray(data.groups) ? data.groups : [];

    // Try to find the group
    let foundGroup: any = null;
    
    if (body.groupName) {
      // Match by name
      foundGroup = groups.find((g: any) => g.name === body.groupName);
    } else if (base64Part) {
      // Match by internal_id or id
      foundGroup = groups.find((g: any) => {
        return (
          g.internal_id === base64Part ||
          g.id === base64Part ||
          g.id === `group.${base64Part}`
        );
      });
    }

    if (!foundGroup) {
      return NextResponse.json(
        {
          error: 'Group not found',
          availableGroups: groups.map((g: any) => ({
            name: g.name || '(unnamed)',
            id: g.id || (g.internal_id ? `group.${g.internal_id}` : null),
          })),
        },
        { status: 404 }
      );
    }

    // Return the resolved group ID
    const resolvedGroupId = foundGroup.id || (foundGroup.internal_id ? `group.${foundGroup.internal_id}` : null);
    
    return NextResponse.json({
      groupId: resolvedGroupId,
      groupName: foundGroup.name || '(unnamed)',
      internalId: foundGroup.internal_id,
    });
  } catch (err: any) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return NextResponse.json(
        { error: 'Group lookup timed out. The Signal bridge may be slow. You can manually enter the group ID.' },
        { status: 504 }
      );
    }
    console.error('[resolve-group] Error:', err);
    return NextResponse.json(
      {
        error: err?.message || 'Failed to resolve group ID',
        details: err?.stack?.substring(0, 500),
      },
      { status: 500 }
    );
  }
}
