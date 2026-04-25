import {StructureBuilder} from 'sanity/desk'

export const deskStructure = (S: StructureBuilder) =>
  S.list()
    .title('Hocan CMS')
    .items([
      S.listItem()
        .title('✍️ Blog Posts')
        .child(
          S.documentTypeList('blogPost')
            .title('Blog Posts')
        ),

      S.listItem()
        .title('💼 Job Posts')
        .child(
          S.documentTypeList('jobPost')
            .title('Job Posts')
        )
    ])

