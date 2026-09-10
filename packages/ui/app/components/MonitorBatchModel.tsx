import {
  Alert, Button, LoadingOverlay, Modal, Stack, Text, Textarea,
  TextInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAdjustmentsHorizontal } from '@tabler/icons-react';
import React, { useState } from 'react';

export function MonitorBatchModal({ refresh }) {
  const [opened, { open, close }] = useDisclosure(false);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [camera, setCamera] = useState('');
  const [desktop, setDesktop] = useState('');
  const [ips, setIps] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState('');
  const inputKey = JSON.stringify({
    name, group, camera, desktop, ips,
  });
  const currentPreview = preview?.inputKey === inputKey ? preview : null;

  const action = async (apply = false) => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/monitor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          group,
          camera,
          desktop,
          ips,
          operation: apply ? 'update_all' : 'preview_all',
          revision: apply ? currentPreview?.revision : undefined,
        }),
      });
      const res = await response.json();
      if (!response.ok || res.error) {
        throw new Error(res.error?.params?.filter((value) => typeof value === 'string').join(' ')
          || res.error?.message || `Request failed (${response.status})`);
      }
      if (apply) {
        notifications.show({ title: 'Success', message: `${res.count} computers updated`, color: 'green' });
        setPreview(null);
        close();
        refresh();
      } else setPreview({ ...res, inputKey });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update computers');
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Modal
        opened={opened}
        onClose={() => { if (!loading) close(); }}
        title="Batch Operation"
        size="md"
        padding="md"
      >
        <LoadingOverlay visible={loading} zIndex={1000} overlayProps={{ radius: 'sm', blur: 2 }} />
        <TextInput label="name" placeholder="Monitor Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <TextInput label="group" placeholder="Group Name" value={group} onChange={(e) => setGroup(e.currentTarget.value)} />
        <TextInput label="camera" placeholder="Camera URL" value={camera} onChange={(e) => setCamera(e.currentTarget.value)} />
        <TextInput label="desktop" placeholder="Desktop URL" value={desktop} onChange={(e) => setDesktop(e.currentTarget.value)} />
        <Textarea label="ips" placeholder="IPs" value={ips} onChange={(e) => setIps(e.currentTarget.value)} />
        {error && <Alert color="red" mt="md" title="Batch edit failed">{error}</Alert>}
        {currentPreview && <Stack gap="xs" mt="md">
          <Text size="sm">{currentPreview.count} computers will be updated.</Text>
          {currentPreview.conflicts.length > 0 && <Alert color="red" title="Duplicate names">{currentPreview.conflicts.join(', ')}</Alert>}
          <div style={{ maxHeight: 220, overflow: 'auto' }}>
            {currentPreview.changes.map((change) => <Text size="xs" key={change.id}>
              {change.before}: {[...Object.entries(change.values).map(([field, value]) => `${field} → ${value}`),
                ...change.cleared.map((field) => `${field} → (clear)`)].join('; ')}
            </Text>)}
            {currentPreview.count > 100 && <Text size="xs">Showing the first 100 changes.</Text>}
          </div>
        </Stack>}
        <Button color="blue" fullWidth mt="md" radius="md" onClick={() => action()}>Preview changes</Button>
        {currentPreview && <Button fullWidth mt="xs" onClick={() => action(true)}
          disabled={!currentPreview.count || currentPreview.conflicts.length > 0}>Apply to {currentPreview.count} computers</Button>}
      </Modal>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconAdjustmentsHorizontal size={15} />}
        onClick={open}
      >
        Batch edit
      </Button>
    </>
  );
}
