import {defineConfig} from 'sanity'
import {deskTool} from 'sanity/desk'
import {deskStructure} from './structure/deskStructure'
import blogPost from './schemaTypes/blogPost'
import jobPost from './schemaTypes/jobPost'

export default defineConfig({
  name: 'hocan-holdings',
  title: 'Hocan Holdings CMS',

  projectId: 'ktbj8t65',
  dataset: 'production',

  plugins: [
    deskTool({
      structure: deskStructure
    })
  ],

  schema: {
    types: [blogPost, jobPost]
  }
})
