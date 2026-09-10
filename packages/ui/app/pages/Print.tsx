import {
  Alert, Card, Center, Group, Pagination, Select, Skeleton,
  Stack, Switch, Text, TextInput, Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertCircle, IconSearch } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { PageHeader } from '../components/PageHeader';
import { PrintTaskAdd } from '../components/PrintAdd';
import { PrintTasksTable } from '../components/PrintTasksTable';
import { printQuery } from '../queries';

export default function Print() {
  const [colorCode, setColorCode] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('all');
  const [locationGroup, setLocationGroup] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const [debouncedSearch] = useDebouncedValue(search, 250);
  const query = useQuery({
    ...printQuery({
      page, search: debouncedSearch, status, group: locationGroup,
    }),
    refetchInterval: 15000,
  });
  const visibleCodes = query.data?.codes || [];
  const printerGroups = React.useMemo(() => Array.from(new Set(
    (query.data?.routing?.routes || []).map((route) => route.group).filter(Boolean),
  )).sort(), [query.data?.routing?.routes]);
  const locationGroups: string[] = query.data?.groups || [];
  const total = query.data?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / 50));
  const currentPage = query.data?.page || page;
  return (
    <>
      <PageHeader
        title="Print"
        description="Review print jobs and the clients responsible for delivering them."
        isFetching={query.isFetching && !query.isPending}
        updatedAt={query.dataUpdatedAt}
        actions={(
          <Group gap="xs" wrap="wrap">
            <Switch
              size="xs"
              label="Color code"
              checked={colorCode}
              onChange={(ev) => setColorCode(ev.currentTarget.checked)}
            />
            <PrintTaskAdd refresh={query.refetch} groups={printerGroups} />
          </Group>
        )}
      />
      {query.isError && !query.data && (
        <Alert color="red" mb="md" title="Unable to load print data" icon={<IconAlertCircle />}>
          Check the server connection and try again.
        </Alert>
      )}
      {query.isError && query.data && (
        <Alert color="yellow" mb="md" title="Refresh failed" icon={<IconAlertCircle />}>
          Showing the most recent print data.
        </Alert>
      )}
      {(!query.isError || query.data) && (
        <Card padding="md" radius="md" withBorder>
          <Group justify="space-between" align="center" mb="md" wrap="wrap">
            <Title order={3} size="h4">Print tasks</Title>
            <Group gap="xs" wrap="wrap">
              <TextInput
                w={{ base: '100%', xs: 'auto' }}
                aria-label="Search print tasks"
                placeholder="Search tasks"
                leftSection={<IconSearch size={16} />}
                value={search}
                onChange={(event) => {
                  setSearch(event.currentTarget.value);
                  setPage(1);
                }}
              />
              <Select
                w={{ base: '100%', xs: 'auto' }}
                aria-label="Filter print tasks by status"
                value={status}
                onChange={(value) => {
                  setStatus(value || 'all');
                  setPage(1);
                }}
                data={[
                  { value: 'all', label: 'All statuses' },
                  { value: 'new', label: 'New' },
                  { value: 'sent', label: 'Sent' },
                  { value: 'needs_review', label: 'Needs review' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'done', label: 'Done' },
                ]}
                allowDeselect={false}
              />
              <Select
                w={{ base: '100%', xs: 'auto' }}
                aria-label="Filter print tasks by location group"
                value={locationGroup}
                onChange={(value) => {
                  setLocationGroup(value || 'all');
                  setPage(1);
                }}
                data={[
                  { value: 'all', label: 'All groups' },
                  ...locationGroups.map((group) => ({ value: group, label: `Group ${group}` })),
                ]}
                allowDeselect={false}
              />
            </Group>
          </Group>
          {query.isPending ? (
            <Stack gap="xs">
              <Skeleton h={36} />
              <Skeleton h={44} />
              <Skeleton h={44} />
            </Stack>
          ) : (!visibleCodes.length ? (
            <Center mt="md">
              <Text c="dimmed">{search || status !== 'all' || locationGroup !== 'all' ? 'No tasks match the filters' : 'No print tasks'}</Text>
            </Center>
          ) : (
            <Stack gap="md">
              <PrintTasksTable colorCode={colorCode} codes={visibleCodes} refresh={query.refetch} />
              {pageCount > 1 && (
                <Group justify="space-between" wrap="wrap">
                  <Text size="xs" c="dimmed">{total} tasks, 50 per page</Text>
                  <Pagination value={currentPage} total={pageCount} onChange={setPage} size="sm" />
                </Group>
              )}
            </Stack>
          ))}
        </Card>
      )}
    </>
  );
}
