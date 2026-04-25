export default {
  name: 'jobPost',
  title: 'Job Post',
  type: 'document',
  fields: [
    { name: 'title', title: 'Job Title', type: 'string' },
    { name: 'location', title: 'Location', type: 'string' },
    { name: 'jobType', title: 'Job Type', type: 'string' },
    {
      name: 'description',
      title: 'Description',
      type: 'array',
      of: [{ type: 'block' }]
    },
    {
      name: 'requirements',
      title: 'Requirements',
      type: 'array',
      of: [{ type: 'string' }]
    }
  ]
}
