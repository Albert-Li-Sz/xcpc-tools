import {
  Alert, Badge, Button, Card, Code, Group, Select, Stack, Table, Text,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { PageHeader } from '../components/PageHeader';
import { fetchJson } from '../queries';

export default function Operations() {
  const [group, setGroup] = React.useState('');
  const query = useQuery({ queryKey: ['operations'], queryFn: ({ signal }) => fetchJson<any>('/operations', signal) });
  const testPrint = () => modals.openConfirmModal({
    title: 'Print a test page',
    children: <Text>This adds one physical test page to the selected printer group. Check the Print page and verify the paper output.</Text>,
    labels: { confirm: 'Submit test page', cancel: 'Cancel' },
    onConfirm: async () => {
      try {
        const response = await fetch('/operations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operation: 'test_print', group }),
        });
        if (!response.ok) throw new Error('Unable to submit test page');
        const result = await response.json();
        notifications.show({ title: 'Test page queued', message: `Task ${result.id}`, color: 'green' });
      } catch (error) { notifications.show({ title: 'Print test failed', message: String(error), color: 'red' }); }
    },
  });
  return (
    <>
      <PageHeader
        title="System checks"
        description="Verify contest readiness and export a diagnostic report."
        isFetching={query.isFetching}
        updatedAt={query.dataUpdatedAt}
        actions={(
          <Group>
            <Button variant="default" onClick={() => query.refetch()}>Run checks</Button>
            <Button component="a" href="/operations?download=1" download>Export diagnostics</Button>
          </Group>
        )}
      />
      <Stack>
        {query.isError && <Alert color="red">System checks could not be loaded. Check the server connection.</Alert>}
        <Card withBorder>
          <Table.ScrollContainer minWidth={620}>
            <Table striped>
              <Table.Thead>
                <Table.Tr><Table.Th>Check</Table.Th><Table.Th>Result</Table.Th><Table.Th>Details</Table.Th></Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(query.data?.checks || []).map((check) => (
                  <Table.Tr key={check.id}>
                    <Table.Td>{check.name}</Table.Td>
                    <Table.Td>
                      <Badge miw={60} color={check.status === 'pass' ? 'green' : check.status === 'fail' ? 'red' : 'yellow'}>{check.status}</Badge>
                    </Table.Td>
                    <Table.Td>{check.detail}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
        <Card withBorder>
          <Stack gap="sm">
            <Text fw={600}>Physical printer test</Text>
            <Group align="flex-end">
              <Select
                label="Printer group"
                value={group}
                onChange={(value) => setGroup(value || '')}
                data={[
                  { value: '', label: 'Global printers' },
                  ...(query.data?.printerGroups || []).filter(Boolean).map((value) => ({ value, label: value })),
                ]}
              />
              <Button onClick={testPrint}>Print test page</Button>
            </Group>
          </Stack>
        </Card>
        <Card withBorder>
          <Stack gap="sm">
            <Text fw={600}>Backup and recovery</Text>
            <Text size="sm">
              Stop the server before backing up or restoring. Backups contain credentials; store them privately.
              Diagnostic exports omit credentials and command contents.
            </Text>
            <Code block>xcpc-tools --backup ./backups/contest.xcpc.gz</Code>
            <Text size="sm">Preview a backup before restoring:</Text>
            <Code block>xcpc-tools --restore ./backups/contest.xcpc.gz</Code>
            <Text size="sm">
              After checking the preview, add --confirm-restore. Current data is retained under backups/.
              Incomplete prints and balloon tickets require review; pending commands are cancelled.
            </Text>
            <Text size="sm">If a restore is interrupted, recover the previous data before restarting:</Text>
            <Code block>xcpc-tools --recover-restore</Code>
          </Stack>
        </Card>
      </Stack>
    </>
  );
}
